CREATE TABLE IF NOT EXISTS master_pi_rmkt (
  pi_no integer NOT NULL,
  pi_date timestamp NOT NULL,
  cust_code smallint NOT NULL,
  pcust_name varchar(60) NOT NULL,
  address varchar(300) NOT NULL,
  city_code smallint NOT NULL,
  state_code smallint NOT NULL,
  contact_no varchar(10) NOT NULL,
  gst_no varchar(15) NOT NULL,
  party_type_code smallint NOT NULL,
  mode_of_transport varchar(25),
  transporter_code smallint NOT NULL,
  destination varchar(25),
  basic_value double precision NOT NULL,
  frt_amount double precision NOT NULL,
  scheme_discount double precision NOT NULL,
  round_off double precision NOT NULL,
  grand_total double precision NOT NULL,
  printer_no integer NOT NULL,
  purch_head varchar(3),
  pi_series varchar(6) NOT NULL,
  spdis_per double precision NOT NULL,
  spdis_amt double precision NOT NULL,
  net_basic_amount double precision NOT NULL,
  del_date timestamp NOT NULL,
  remarks varchar(250),
  close_yn varchar(1) NOT NULL,
  po_no varchar(50),
  sch_code integer NOT NULL,
  inv_type smallint NOT NULL,
  igst_per double precision NOT NULL,
  cgst_per double precision NOT NULL,
  sgst_per double precision NOT NULL,
  igst_amt double precision NOT NULL,
  cgst_amt double precision NOT NULL,
  sgst_amt double precision NOT NULL,
  oth_dis_amt double precision NOT NULL,
  oth_dis_per double precision NOT NULL,
  close_date timestamp,
  remark_footer varchar(250) NOT NULL,
  tod_per double precision NOT NULL DEFAULT 0,
  tod_amt double precision NOT NULL DEFAULT 0,
  cd_per double precision NOT NULL,
  cd_amt double precision NOT NULL,
  net_taxable_value double precision NOT NULL,
  comp_code smallint NOT NULL,
  oth_sp_disc varchar(16) NOT NULL,
  oth_spdis_per double precision NOT NULL,
  oth_spdis_amt double precision NOT NULL,
  buy_fly_per double precision NOT NULL,
  buy_fly_amt double precision NOT NULL,
  pcust_disc_per double precision NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(50),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by varchar(50),
  updated_at timestamp,
  PRIMARY KEY (pi_no, pi_series, comp_code)
);

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS tod_per double precision NOT NULL DEFAULT 0;

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS tod_amt double precision NOT NULL DEFAULT 0;

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS created_by varchar(50);

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS updated_by varchar(50);

ALTER TABLE master_pi_rmkt
  ADD COLUMN IF NOT EXISTS updated_at timestamp;

CREATE TABLE IF NOT EXISTS tran_pi_rmkt (
  pi_no integer NOT NULL,
  product_code varchar(16) NOT NULL,
  quantity double precision NOT NULL,
  uom_code numeric NOT NULL,
  rate double precision NOT NULL,
  amount double precision NOT NULL,
  rbasic double precision NOT NULL,
  drate double precision NOT NULL,
  damt double precision NOT NULL,
  pi_series varchar(6) NOT NULL,
  comp_code smallint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(50),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by varchar(50),
  updated_at timestamp,
  PRIMARY KEY (pi_no, product_code, pi_series, comp_code),
  FOREIGN KEY (pi_no, pi_series, comp_code)
    REFERENCES master_pi_rmkt (pi_no, pi_series, comp_code)
    ON DELETE CASCADE
);

ALTER TABLE tran_pi_rmkt
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE tran_pi_rmkt
  ADD COLUMN IF NOT EXISTS created_by varchar(50);

ALTER TABLE tran_pi_rmkt
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE tran_pi_rmkt
  ADD COLUMN IF NOT EXISTS updated_by varchar(50);

ALTER TABLE tran_pi_rmkt
  ADD COLUMN IF NOT EXISTS updated_at timestamp;
