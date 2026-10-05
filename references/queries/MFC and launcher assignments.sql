/*
select s.* from FCT_Ship as s
inner join FCT_Fleet as f on f.FleetID = s.FleetID
where f.FleetName = 'ODP Sponge 001'
28982
29388
29409
29419
29427
29434
*/
select * from FCT_MissileAssignment where ShipID in (29946,30006)

insert into FCT_MissileAssignment
with RECURSIVE rows(ShipID,MissileID,WeaponID,WeaponNum,GameID) AS
(
select s.ShipID	,90775 as MissileID	,89925 as WeaponID	,1 as WeaponNum	,47 as GameID from FCT_Ship as s where s.ShipID in (29946,30006) -- s.FleetID = 32502
union ALL
select ShipID	,MissileID	,WeaponID	,rows.WeaponNum+1 as WeaponNum	,GameID from rows where rows.WeaponNum<50
)
select * from rows

/*
delete from FCT_MissileAssignment where ShipID in (28882,28982,29897)

select * from FCT_WeaponAssignment where ShipID in (29946,30006)

insert into FCT_WeaponAssignment
with RECURSIVE rows(ShipID,WeaponID,WeaponNum, FCTypeID,FCNum,GameID) AS
(
select s.ShipID	,89925 as WeaponID ,1 as WeaponNum ,90397 as FCTypeID, 1 as FCNum	,47 as GameID from FCT_Ship as s where s.ShipID in (29946,30006) --  s.FleetID = 32502 --(29454, 29474, 29498, 29854)
union ALL
select ShipID	,WeaponID	,rows.WeaponNum+1 as WeaponNum	,FCTypeID, FCNum, GameID from rows where rows.WeaponNum<50
)
select * from rows
*/

/*
insert into FCT_MissileAssignment (ShipID, MissileID, WeaponID, WeaponNum, GameID) VALUES select ShipID, MissileID, WeaponID, 1, GameID from cte_const
insert into FCT_MissileAssignment (ShipID, MissileID, WeaponID, WeaponNum, GameID) VALUES select ShipID, MissileID, WeaponID, 2, GameID from cte_const

SELECT
	sw.*
FROM
	FCT_ShipWeapon as sw
inner join FCT_Ship as s on s.ShipID = sw.ShipID
inner join FCT_Fleet as f on f.FleetID = s.FleetID
WHERE f.FleetID = 32502
	
SELECT
	ma.*
FROM
	FCT_MissileAssignment as ma
inner join FCT_Ship as s on s.ShipID = ma.ShipID
inner join FCT_Fleet as f on f.FleetID = s.FleetID
WHERE f.FleetID = 32502
--WHERE	ma.ShipID in (28982,29388,29409,29419,29427,29434)--(29454, 29474, 29498, 29854)
	
SELECT
	wa.*
FROM
	FCT_WeaponAssignment as wa
inner join FCT_Ship as s on s.ShipID = wa.ShipID
inner join FCT_Fleet as f on f.FleetID = s.FleetID
WHERE f.FleetID = 32502
*/